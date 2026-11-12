import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  ChevronDown,
  ImagePlus,
  Loader2,
  ScanSearch,
  Sparkles,
  X,
} from 'lucide-react';
import type { AnalysisResponse, M5Execution, PipelineReport, RiskSettings, Status, Timeframe } from '../types';
import { api, brokerOffset, costsFor, cx, distanceLabel, etoroSize, fmt, localDateTime, localTime, lotScale, lotSize, minLotRiskUsd, realRiskUsd, riskForGrade, readJson, maTz, TEST_RISK_PCT, killzonesMaroc } from '../lib/utils';
import type { StrategyStats } from '../lib/tracker';
import { deskCheckFx, splitOrders, type FxDesk } from '../lib/desk';
import { useWatchStatus } from './AlertsCard';

interface Props {
  pair: string;
  status: Status | null;
  settings: RiskSettings;
  analysis: AnalysisResponse | null;
  setAnalysis: (a: AnalysisResponse | null) => void;
  onAddJournal: (a: AnalysisResponse, test?: boolean) => string | null;
  dailyBlocked: boolean;
  /** règles du desk sur le compte réel (journal FxPro) ; null sans cTrader */
  desk?: FxDesk | null;
  dailyLossPct?: number;
  stats: StrategyStats;
}

async function downscale(file: File): Promise<{ base64: string; mediaType: string; preview: string }> {
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  const max = 1600;
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', preview: dataUrl };
}

const trendCls = (t: string) => (t === 'haussier' ? 'text-up' : t === 'baissier' ? 'text-down' : 'text-mute');

export function AnalysisPanel({ pair, status, settings, analysis, setAnalysis, onAddJournal, dailyBlocked, stats, desk = null, dailyLossPct = 3 }: Props) {
  const [note, setNote] = useState('');
  const [image, setImage] = useState<{ base64: string; mediaType: string; preview: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setAdded(false);
    setAddError(null);
    try {
      const provider = settings.aiProvider === 'auto' ? undefined : settings.aiProvider;
      const r = await api('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair,
          provider,
          ...costsFor(pair, settings),
          note: note.trim() || undefined,
          image: image ? { base64: image.base64, mediaType: image.mediaType } : undefined,
        }),
      });
      const j = await readJson(r);
      if (!r.ok) throw new Error(j.error || 'Erreur pendant l’analyse.');
      setAnalysis(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const a = analysis && analysis.pair === pair ? analysis : null;
  const aiOff = settings.aiProvider === 'none' || !status?.providers.length;

  // l'analyse se lance toute seule à l'ouverture et au changement d'actif (plus de 5 min = périmée)
  useEffect(() => {
    if (!loading && (!a || Date.now() - a.generatedAt > 5 * 60_000)) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair]);

  return (
    <div className="space-y-3">
      {loading && !a && (
        <section className="card flex items-center gap-3 p-4 text-sm text-mute">
          <Loader2 className="h-5 w-5 spin text-gold" /> Analyse de {pair} en cours…
        </section>
      )}
      {error && <p className="card border-down/50 px-3 py-2 text-sm text-down">{error}</p>}
      {a && (
        <div key={a.generatedAt}>
          <Result a={a} settings={settings} stats={stats} desk={desk} dailyLossPct={dailyLossPct} dailyBlocked={dailyBlocked} />
        </div>
      )}
      {/* Relancer l'analyse (avec note ou capture) */}
      <section className="card space-y-3 p-3">
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder="Note optionnelle (ex : je vise une vente sur Londres, news US à 14h30…)"
          className="w-full resize-none rounded-lg border border-line bg-card2 px-3 py-2 text-sm text-ink placeholder:text-mute focus:border-gold focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async e => {
              const f = e.target.files?.[0];
              if (f) setImage(await downscale(f));
              e.target.value = '';
            }}
          />
          {image ? (
            <div className="relative">
              <img src={image.preview} alt="Capture" className="h-11 w-16 rounded-md border border-line object-cover" />
              <button onClick={() => setImage(null)} className="absolute -right-2 -top-2 rounded-full bg-down p-0.5 text-bg" aria-label="Retirer">
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={aiOff}
              className="flex h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-mute disabled:opacity-40"
              title={aiOff ? 'Une IA est nécessaire pour lire une capture' : ''}
            >
              <ImagePlus className="h-4 w-4" /> Capture
            </button>
          )}
          <button
            onClick={run}
            disabled={loading}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-gold text-sm font-bold text-bg disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 spin" /> : <ScanSearch className="h-4 w-4" />}
            {loading ? 'Analyse en cours…' : a ? `Relancer l’analyse ${pair}` : `Analyser ${pair}`}
          </button>
        </div>
        {aiOff && (
          <p className="text-xs text-mute">
            {status?.providers.length ? 'IA désactivée dans les réglages' : 'Aucune clé IA configurée'} : analyse calculée par le moteur uniquement.
          </p>
        )}
      </section>

    </div>
  );
}

function Result({ a, settings, stats, desk, dailyLossPct, dailyBlocked }: { a: AnalysisResponse; settings: RiskSettings; stats: StrategyStats; desk: FxDesk | null; dailyLossPct: number; dailyBlocked: boolean }) {
  const { engine: e, final, ai } = a;
  const dec = a.decimals;
  const plan = final.plan;
  const go = final.signal !== 'attendre';
  const okCount = e.checklist.filter(c => c.ok).length;
  const comm = a.costs?.commissionPerLot ?? 0;
  const riskPct = riskForGrade(settings.riskPct, e.grade);
  const scale = lotScale(settings.broker);
  const cent = settings.broker === 'cent';
  const lots = plan ? lotSize(a.pair, settings.capital, riskPct, plan.entry, plan.sl, comm, scale) : null;
  const riskUsd = plan && lots ? realRiskUsd(a.pair, lots, plan.entry, plan.sl, comm, scale) : (settings.capital * riskPct) / 100;
  const tfs: Timeframe[] = ['D1', 'H4', 'H1', 'M15'];
  const broker = useBrokerOffset(a);
  const shift = (v: number | null) => (v === null ? null : v + broker.offset);

  // règle du desk sur le compte réel (ou garde-fou local) : affichée sur la carte d'ordre
  const deskMsg = (dir: 'acheter' | 'vendre') =>
    desk ? deskCheckFx(desk, a.pair, dir, dailyLossPct) : dailyBlocked ? 'Limite de perte du jour atteinte : stop pour aujourd’hui.' : null;
  const tr = e.training && final.signal === 'attendre' && e.training.ready !== false ? e.training.setup : null;
  const trLots = tr ? lotSize(a.pair, settings.capital, TEST_RISK_PCT, tr.entry, tr.sl, comm, scale) : null;

  return (
    <div className="space-y-3">
      {a.verdict && <VerdictCard v={a.verdict} stats={stats} score={e.setup ? e.score : null} grade={e.setup ? e.grade : undefined} />}
      {final.signal === 'attendre' && <WatchLine />}
      {a.paused && (
        <section className="card border border-warn/40 p-4">
          <div className="label mb-1 text-warn">Actif en pause</div>
          <p className="text-sm leading-snug text-ink/90">{a.paused}</p>
        </section>
      )}
      {go && plan && (settings.broker ?? 'mt5') !== 'etoro' && (
        <OrderCard
          pair={a.pair}
          long={plan.direction === 'acheter'}
          limit={plan.entryType === 'limite'}
          entry={shift(plan.entry)!}
          sl={shift(plan.sl)!}
          tp1={shift(plan.tp1)!}
          tp2={shift(plan.tp2)}
          lots={lots}
          riskUsd={riskUsd}
          riskPct={riskPct}
          cent={cent}
          dec={dec}
          validUntil={e.setup?.validUntil ?? null}
          deskMsg={deskMsg(plan.direction)}
          minLotUsd={lots === 0 ? minLotRiskUsd(a.pair, plan.entry, plan.sl, comm, scale) : null}
        />
      )}
      {a.execution && a.execution.stage !== 'ordre' && <ExecutionCard x={a.execution} dec={dec} shift={broker.offset} />}
      {e.training && final.signal === 'attendre' && <TrainingCard a={a} shift={broker.offset} />}
      {tr && (
        <OrderCard
          test
          pair={a.pair}
          long={tr.direction === 'acheter'}
          limit={tr.entryType === 'limite'}
          entry={shift(tr.entry)!}
          sl={shift(tr.sl)!}
          tp1={shift(tr.tp1)!}
          tp2={shift(tr.tp2)}
          lots={trLots}
          riskUsd={trLots ? realRiskUsd(a.pair, trLots, tr.entry, tr.sl, comm, scale) : 0}
          riskPct={TEST_RISK_PCT}
          cent={cent}
          dec={dec}
          validUntil={tr.validUntil ?? null}
          deskMsg={deskMsg(tr.direction)}
          minLotUsd={trLots === 0 ? minLotRiskUsd(a.pair, tr.entry, tr.sl, comm, scale) : null}
        />
      )}

      <details className="group space-y-3">
        <summary className="card flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold">
          Détails de l’analyse (structure, zones, checklist, volume, IA)
          <ChevronDown className="h-4 w-4 text-mute transition group-open:rotate-180" />
        </summary>
        <div className="mt-3 space-y-3">
      {a.volumeProfile && <VolumeProfileCard vp={a.volumeProfile} dec={dec} shift={broker.offset} />}
      {a.pipeline && <PipelineCard p={a.pipeline} dec={dec} />}

      {/* Verdict */}
      <section
        className={cx(
          'card p-4',
          final.signal === 'acheter' && 'border-up/60',
          final.signal === 'vendre' && 'border-down/60'
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label">Signal technique du moteur</div>
            <div
              className={cx(
                'mt-1 text-3xl font-extrabold tracking-tight',
                final.signal === 'acheter' ? 'text-up' : final.signal === 'vendre' ? 'text-down' : 'text-warn'
              )}
            >
              {final.signal === 'attendre' ? 'ATTENDRE' : final.signal === 'acheter' ? 'ACHETER' : 'VENDRE'}
            </div>
            {plan && go && <div className="mt-0.5 text-xs text-mute">Ordre {plan.entryType === 'limite' ? 'limite' : 'au marché'}</div>}
          </div>
          <div className="text-right">
            <div className="label">Confluence</div>
            <div className="num mt-1 text-2xl font-bold">
              {okCount}
              <span className="text-mute">/{e.checklist.length}</span>
            </div>
          </div>
        </div>
        {!go && e.waitCondition && <p className="mt-3 text-sm leading-snug text-ink/90">{e.waitCondition}</p>}
        {e.amd && (
          <div className="mt-3 rounded-lg bg-card2 px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold">Cycle AMD du jour</span>
              <span
                className={cx(
                  'rounded px-1.5 py-0.5 text-xs font-bold',
                  e.amd.phase === 'Distribution' ? 'bg-gold/20 text-gold' : e.amd.phase === 'Manipulation' ? 'bg-warn/15 text-warn' : 'bg-white/5 text-mute'
                )}
              >
                {e.amd.phase}
                {e.amd.direction ? ` · ${e.amd.direction}` : ''}
              </span>
            </div>
            <p className="mt-1 text-xs leading-snug text-mute">{e.amd.detail}</p>
          </div>
        )}
        {ai?.resume && <p className="mt-3 border-t border-line pt-3 text-sm leading-snug text-ink/90">{ai.resume}</p>}
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
          <span>
            Prix <span className="num text-ink">{fmt(e.price, dec)}</span>{' '}
            {a.livePriceAt
              ? `en direct à ${new Date(a.livePriceAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: maTz(a.livePriceAt) })}`
              : `à ${localTime(e.priceTime)} (prix en direct indisponible : vérifie chez ton broker)`}
          </span>
          <span>{e.session.name}</span>
          <span>Source : {a.source}</span>
        </div>
        {/* recalage sur le prix du broker : inutile quand les données viennent déjà de cTrader (FxPro) */}
        {!a.source.includes('cTrader') && <div className="mt-3"><BrokerPriceBox a={a} broker={broker} /></div>}
        {e.nextNews && (
          <p className="mt-2 text-xs text-mute">
            Prochaine annonce forte : <span className="text-ink">{e.nextNews.title}</span> ({e.nextNews.currency}), {localDateTime(e.nextNews.t)}
          </p>
        )}
        {a.warnings.map(w => (
          <p key={w} className="mt-2 flex gap-1.5 text-xs leading-snug text-warn">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {w}
          </p>
        ))}
      </section>

      {/* Plan */}
      {plan && (
        <section className={cx('card p-4', !go && 'opacity-80')}>
          <div className="mb-3 flex items-center justify-between">
            <div className="label">{go ? 'Plan de trade' : 'Plan en préparation (pas d’entrée pour l’instant)'}</div>
            <span className="text-xs text-mute">{plan.origin}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Level label="Entrée" value={fmt(shift(plan.entry), dec)} cls="text-gold" />
            <Level label="Stop loss" value={fmt(shift(plan.sl), dec)} sub={distanceLabel(a.pair, plan.entry, plan.sl)} cls="text-down" />
            <Level label="TP1" value={fmt(shift(plan.tp1), dec)} sub={`R:R 1:${plan.rr1.toFixed(1)}`} cls="text-up" />
            <Level label="TP2" value={fmt(shift(plan.tp2), dec)} sub={plan.rr2 ? `R:R 1:${plan.rr2.toFixed(1)}` : 'pas de 2e cible'} cls="text-up" />
          </div>
          {broker.offset !== 0 && (
            <p className="mt-1.5 text-xs leading-snug text-mute">
              Niveaux recalés sur ton broker ({broker.offset > 0 ? '+' : ''}{fmt(broker.offset, dec)}). Niveaux de l’app (flux Twelve Data, utilisés par le suivi du journal) : entrée {fmt(plan.entry, dec)}, stop {fmt(plan.sl, dec)}, TP1 {fmt(plan.tp1, dec)}{plan.tp2 !== null ? `, TP2 ${fmt(plan.tp2, dec)}` : ''}.
            </p>
          )}
          <div className="mt-3 rounded-lg bg-card2 px-3 py-2 text-xs">
            {(settings.broker ?? 'mt5') === 'etoro' && lots !== null && lots > 0 ? (
              (() => {
                const z = etoroSize(a.pair, lots, plan.entry, a.pair === 'XAU/USD' ? settings.leverageGold ?? 20 : settings.leverageEur ?? 30);
                return (
                  <>
                    <div className="flex justify-between">
                      <span className="text-mute">eToro, pour {riskPct} % de risque{e.grade === 'B' ? ' (classe B : risque /2)' : ''}</span>
                      <span className="num font-semibold">{z.units.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} {a.pair === 'XAU/USD' ? 'onces' : 'unités'}</span>
                    </div>
                    <div className="mt-1 flex justify-between">
                      <span className="text-mute">Montant à investir (levier 1:{z.leverage})</span>
                      <span className="num">≈ {z.amount.toFixed(0)} $</span>
                    </div>
                    <div className="mt-1 flex justify-between">
                      <span className="text-mute">Valeur exposée</span>
                      <span className="num">≈ {z.exposure.toFixed(0)} $</span>
                    </div>
                    {z.amount > settings.capital && (() => {
                      // capital insuffisant avec ce levier : on réduit la taille, le risque réel baisse d'autant
                      const ratio = settings.capital / z.amount;
                      const maxUnits = z.units * ratio;
                      return (
                        <p className="mt-1.5 rounded bg-warn/10 px-2 py-1 text-xs leading-snug text-warn">
                          Montant supérieur à ton capital avec un levier 1:{z.leverage}. Taille maximale : {maxUnits.toLocaleString('fr-FR', { maximumFractionDigits: a.pair === 'XAU/USD' ? 2 : 0 })} {a.pair === 'XAU/USD' ? 'onces' : 'unités'} pour {settings.capital.toFixed(0)} $ investis, soit un risque réel d’environ {(riskPct * ratio).toFixed(2)} % au lieu de {riskPct} %.
                        </p>
                      );
                    })()}
                  </>
                );
              })()
            ) : (
              <div className="flex justify-between">
                <span className="text-mute">{cent ? 'Compte cent, taille' : 'Taille'} pour {riskPct} % de risque{e.grade === 'B' ? ' (classe B : risque divisé par 2)' : ''}</span>
                <span className="num font-semibold">{lots === null ? '—' : `${lots.toFixed(2)} lot${cent ? ' cent' : ''}`}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between">
              <span className="text-mute">Perte réelle si SL touché</span>
              <span className="num">≈ {riskUsd < 10 ? riskUsd.toFixed(2) : riskUsd.toFixed(0)} ${cent ? ` (${(riskUsd * 100).toFixed(0)} USC)` : ''}</span>
            </div>
            <div className="mt-1 text-xs text-mute">
              R:R nets : spread {a.pair === 'XAU/USD' ? `${a.costs.spread.toFixed(2)} $` : `${(a.costs.spread / 0.0001).toFixed(1)} pip`} et commission {comm} $/lot inclus.
            </div>
            {lots === 0 && (
              <p className="mt-1 text-warn">
                Stop trop large pour ton capital : même 0,01 lot{cent ? ' cent' : ''} ferait perdre ≈ {minLotRiskUsd(a.pair, plan.entry, plan.sl, comm, scale).toFixed(2)} $ ({((minLotRiskUsd(a.pair, plan.entry, plan.sl, comm, scale) / settings.capital) * 100).toFixed(1)} % du compte, au lieu de {riskPct} %). Ne prends pas ce trade{cent ? '' : ', ou passe sur un compte cent'}.
              </p>
            )}
            {(settings.broker ?? 'mt5') === 'etoro' && (
              <p className="mt-1 text-xs text-mute">Sur eToro : saisis le montant avec ce levier, vérifie que le nombre d’unités affiché correspond, puis pose le stop loss et le take profit aux niveaux ci-dessus.</p>
            )}
          </div>
          {e.setup && <p className="mt-2 text-xs text-mute">Zone : {e.setup.zoneLabel}</p>}
          {e.setup?.validUntil && plan.entryType === 'limite' && (
            <p className="mt-1 text-xs text-mute">Ordre limite à annuler s’il n’est pas exécuté avant {localTime(e.setup.validUntil)}.</p>
          )}
          {final.notes.map(n => (
            <p key={n} className="mt-1 text-xs text-mute">• {n}</p>
          ))}
        </section>
      )}

      {/* Concepts ICT + bougies japonaises */}
      <IctBox a={a} />
      <CandleBox a={a} />

      {/* Checklist */}
      <section className="card p-4">
        <div className="label mb-2">Checklist</div>
        <ul className="space-y-2">
          {e.checklist.map(c => (
            <li key={c.key} className="flex gap-2.5">
              <span className={cx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full', c.ok ? 'bg-up/20 text-up' : 'bg-down/15 text-down')}>
                {c.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              </span>
              <div className="min-w-0">
                <div className="text-sm">
                  {c.label}
                  {c.core && <span className="ml-1.5 text-xs text-gold">obligatoire</span>}
                </div>
                <div className="text-xs leading-snug text-mute">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Multi-timeframe */}
      <section className="card p-4">
        <div className="label mb-2">Structure par unité de temps</div>
        <div className="grid grid-cols-[3rem_1fr_1fr_3rem] gap-y-2 text-xs">
          <span className="text-mute">UT</span>
          <span className="text-mute">Tendance</span>
          <span className="text-mute">Dernière cassure</span>
          <span className="text-right text-mute">RSI</span>
          {tfs.map(tf => {
            const s = e.timeframes[tf];
            return (
              <div key={tf} className="contents">
                <span className="font-semibold">{tf}</span>
                <span className={trendCls(s.trend)}>{s.trend}</span>
                <span className="text-mute">
                  {s.lastEvent ? `${s.lastEvent.kind} ${s.lastEvent.dir === 'bull' ? '↑' : '↓'} ${fmt(s.lastEvent.level, dec)}` : '—'}
                </span>
                <span className="num text-right">{s.rsi14 ? s.rsi14.toFixed(0) : '—'}</span>
              </div>
            );
          })}
        </div>
        {e.dealingRange && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-mute">
              <span className="num">{fmt(e.dealingRange.low, dec)}</span>
              <span>Range H1 : {e.dealingRange.label}</span>
              <span className="num">{fmt(e.dealingRange.high, dec)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-gradient-to-r from-up/40 via-card2 to-down/40">
              <div className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded bg-ink" style={{ left: `calc(${Math.min(100, Math.max(0, e.dealingRange.position * 100))}% - 2px)` }} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-mute">
              <span>discount (achats)</span>
              <span>premium (ventes)</span>
            </div>
          </div>
        )}
      </section>

      {/* Liquidité + zones */}
      <section className="card p-4">
        <div className="label mb-2">Liquidité</div>
        <ul className="space-y-1.5 text-xs">
          {e.liquidity.map(l => (
            <li key={l.id} className={cx('flex items-center justify-between gap-2', l.swept && 'opacity-50')}>
              <span className="min-w-0 truncate">
                <span className={l.side === 'buy' ? 'text-up' : 'text-down'}>{l.side === 'buy' ? '▲' : '▼'}</span> {l.label}
                {l.swept && <span className="ml-1 text-xs">(déjà pris)</span>}
              </span>
              <span className="num shrink-0">{fmt(l.price, dec)}</span>
            </li>
          ))}
          {!e.liquidity.length && <li className="text-mute">Aucun niveau proche.</li>}
        </ul>
        <div className="label mb-2 mt-4">Zones d’intérêt actives</div>
        <ul className="space-y-1.5 text-xs">
          {e.zones.map(z => (
            <li key={z.id} className="flex items-center justify-between gap-2">
              <span>
                <span className={z.dir === 'bull' ? 'text-up' : 'text-down'}>{z.kind}</span> {z.tf} {z.dir === 'bull' ? 'haussier' : 'baissier'}
                {z.touched && <span className="ml-1 text-xs text-mute">(déjà testé)</span>}
              </span>
              <span className="num shrink-0">
                {fmt(z.bottom, dec)} – {fmt(z.top, dec)}
              </span>
            </li>
          ))}
          {!e.zones.length && <li className="text-mute">Aucun FVG/OB valide à proximité.</li>}
        </ul>
      </section>

      {/* IA */}
      {(ai || a.aiError) && (
        <section className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="label flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-gold" /> Lecture de l’IA
            </div>
            {ai && (
              <span className={cx('rounded px-1.5 py-0.5 text-xs font-bold', ai.verdict === 'VALIDÉ' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                {ai.verdict}
              </span>
            )}
          </div>
          {a.aiError && <p className="text-xs text-warn">{a.aiError}</p>}
          {ai && (
            <div className="space-y-1">
              {ai.lecture_capture && <Fold title="Ta capture d’écran" text={ai.lecture_capture} open />}
              <Fold title="Contexte" text={ai.contexte} open />
              <Fold title="Liquidité" text={ai.liquidite} />
              <Fold title="Zones" text={ai.zones} />
              <Fold title="Plan" text={ai.plan} open />
              <Fold title="Gestion" text={ai.gestion} />
              <Fold title="Invalidation" text={ai.invalidation} />
              <p className="pt-2 text-xs text-mute">{ai.engine} · {localDateTime(a.generatedAt)}</p>
            </div>
          )}
        </section>
      )}

        </div>
      </details>

      <p className="px-2 text-center text-xs leading-snug text-mute">
        Outil d’aide à la décision, pas un conseil en investissement. Le trading avec effet de levier peut faire perdre plus que la mise : teste d’abord en démo.
      </p>
    </div>
  );
}

function VerdictCard({ v, stats, score, grade }: { v: NonNullable<AnalysisResponse['verdict']>; stats: StrategyStats; score: number | null; grade?: 'A+' | 'B' | 'C' }) {
  const take = v.action !== 'ATTENDRE';
  const pct = stats.viability;
  const ok = pct !== null && pct >= v.threshold;
  return (
    <section className="card overflow-hidden">
      {/* bandeau du verdict : vert = achat, rouge = vente, orange = attendre */}
      <div className={cx('px-4 py-3 text-white', v.action === 'ACHETER' ? 'bg-up' : v.action === 'VENDRE' ? 'bg-down' : 'bg-warn')}>
        <div className="text-[12px] font-semibold opacity-90">Verdict de ta stratégie</div>
        <div className="text-[34px] font-extrabold leading-tight tracking-tight">{v.action === 'ACHETER' ? 'Achat' : v.action === 'VENDRE' ? 'Vente' : 'Attendre'}</div>
      </div>
      <div className="p-4 pt-3">
      <p className="text-sm leading-snug">{v.summary}</p>
      {score !== null && grade && (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-card2 px-3 py-2">
          <span className="text-xs text-mute">Qualité du setup (grille SMC, pas une probabilité)</span>
          <span className={cx('num text-sm font-bold', grade === 'A+' ? 'text-up' : grade === 'B' ? 'text-warn' : 'text-down')}>
            {grade} · {score}/100
          </span>
        </div>
      )}
      <div className="mt-3 rounded-lg bg-card2 px-3 py-2">
        <div className="flex items-end justify-between">
          <span className="text-xs text-mute">Viabilité (trades réels de l’app sur ton compte)</span>
          <span className={cx('num text-2xl font-bold', ok ? 'text-up' : 'text-ink')}>{pct === null ? '—' : `${pct} %`}</span>
        </div>
        {pct === null ? (
          <>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-card2">
              <div className="h-full bg-gold" style={{ width: `${Math.min(100, (stats.closed / stats.minTrades) * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-mute">
              {stats.closed}/{stats.minTrades} trades réels clôturés : la viabilité s’affichera à partir de {stats.minTrades}.
            </p>
          </>
        ) : (
          <>
            <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-card2">
              <div className={cx('h-full', ok ? 'bg-up' : 'bg-warn')} style={{ width: `${pct}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${v.threshold}%` }} />
            </div>
            <p className="mt-1 text-xs text-mute">
              Sur {stats.closed} trades : {stats.winRate} % gagnants, {stats.avgR !== null && stats.avgR >= 0 ? '+' : ''}{stats.avgR} R en moyenne (fourchette 95 % : {stats.ciLow} à {stats.ciHigh} R). Ton seuil : {v.threshold} %.
              {stats.ciLow !== null && stats.ciLow <= 0 && ' La fourchette inclut zéro : l’avantage n’est pas encore prouvé.'}
            </p>
          </>
        )}
      </div>
      {v.pour.length > 0 && (
        <details className="mt-3 rounded-lg bg-card2 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-up">Pour ({v.pour.length})</summary>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-snug">
            {v.pour.map(x => (
              <li key={x}>✓ {x}</li>
            ))}
          </ul>
        </details>
      )}
      {v.contre.length > 0 && (
        <details className="mt-2 rounded-lg bg-card2 px-3 py-2" open={!take && v.contre.length <= 4}>
          <summary className="cursor-pointer text-xs font-semibold text-down">Contre ({v.contre.length})</summary>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-snug">
            {v.contre.map(x => (
              <li key={x}>✗ {x}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="mt-2 text-xs text-mute">
        <summary className="cursor-pointer py-1">Comment lire ce verdict et la viabilité</summary>
      <p className="mt-1 leading-snug">
        Le verdict vient uniquement des règles de ta stratégie. La viabilité est un indice de confiance, calculé sur tes trades suivis automatiquement (version actuelle des règles), que la moyenne en R soit positive. Ce n’est ni la chance de gagner ce trade, ni une preuve : avec 30 trades, une stratégie sans avantage peut dépasser 85 % par hasard. Pour le réel, vise au moins 100 trades et une fourchette entièrement au-dessus de 0.
      </p>
      </details>
      </div>
    </section>
  );
}

function IctBox({ a }: { a: AnalysisResponse }) {
  const ict = a.engine.ict;
  if (!ict) return null;
  const dec = a.decimals;
  return (
    <section className="card p-4">
      <div className="label mb-2">Concepts ICT de la zone</div>
      <ul className="space-y-1.5 text-xs">
        <li className="flex justify-between gap-2">
          <span className="text-mute">Displacement à l’origine de la zone</span>
          <span className={ict.displacement ? 'text-up' : 'text-mute'}>{ict.displacement ? 'oui' : 'non'}</span>
        </li>
        <li className="flex justify-between gap-2">
          <span className="text-mute">OTE (62–79 %)</span>
          <span className="num">{ict.ote ? `${fmt(ict.ote.bottom, dec)} – ${fmt(ict.ote.top, dec)}` : '—'}</span>
        </li>
        {ict.trendlines.map(t => (
          <li key={`${t.side}-${t.firstT}`} className={cx('flex justify-between gap-2', !t.intact && 'opacity-50')}>
            <span className="min-w-0 truncate">
              <span className={t.side === 'buy' ? 'text-up' : 'text-down'}>{t.side === 'buy' ? '▲' : '▼'}</span> {t.label}
              {!t.intact && <span className="ml-1 text-xs">(déjà prise)</span>}
            </span>
            <span className="num shrink-0">{fmt(t.priceNow, dec)}</span>
          </li>
        ))}
        {!ict.trendlines.length && <li className="text-mute">Aucune trendline de 3 touches sur M15/H1.</li>}
      </ul>
    </section>
  );
}

function CandleBox({ a }: { a: AnalysisResponse }) {
  const list = a.candlePatterns || [];
  const dir = a.final.plan?.direction ?? a.engine.setup?.direction ?? null;
  const want = dir === 'acheter' ? 'haussier' : dir === 'vendre' ? 'baissier' : null;
  return (
    <section className="card p-4">
      <div className="label mb-2">Bougies japonaises (confirmation)</div>
      {!list.length && <p className="text-xs text-mute">Aucune figure de retournement sur les 3 dernières bougies M15 et les 2 dernières H1.</p>}
      <ul className="space-y-2">
        {list.map(p => (
          <li key={`${p.tf}-${p.t}-${p.name}`} className="rounded-lg bg-card2 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className={cx('font-semibold', p.dir === 'haussier' ? 'text-up' : 'text-down')}>{p.name}</span>
              <span className="text-xs text-mute">
                {p.tf} · {localTime(p.t)}
                {p.inZone ? ' · dans la zone' : ''}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-mute">{p.detail}</p>
            {want && (
              <p className={cx('mt-0.5 text-xs font-semibold', p.dir === want ? 'text-up' : 'text-down')}>
                {p.dir === want ? 'Dans le sens du plan' : 'Contre le plan'}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-snug text-mute">
        Critère de décision (ebook) : une figure dans le sens du plan, formée dans la zone d’entrée, compte comme une confluence. Une figure contre le plan est signalée dans le « Contre ».
      </p>
    </section>
  );
}

function Level({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls: string }) {
  return (
    <div className="rounded-lg bg-card2 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-mute">{label}</div>
      <div className={cx('num text-base font-semibold', cls)}>{value}</div>
      {sub && <div className="text-xs text-mute">{sub}</div>}
    </div>
  );
}

function Fold({ title, text, open }: { title: string; text: string; open?: boolean }) {
  if (!text) return null;
  return (
    <details open={open} className="group rounded-lg bg-card2 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold">
        {title}
        <ChevronDown className="h-3.5 w-3.5 text-mute transition group-open:rotate-180" />
      </summary>
      <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-ink/90">{text}</p>
    </details>
  );
}

function useBrokerOffset(a: AnalysisResponse) {
  const [text, setText] = useState('');
  const [enteredAt, setEnteredAt] = useState<number | null>(null);
  const { offset, error } = brokerOffset(a.pair, a.engine.price, text, a.costs?.spread ?? 0);
  return {
    text,
    setText: (v: string) => {
      setText(v);
      setEnteredAt(v.trim() ? Date.now() : null);
    },
    offset,
    error,
    enteredAt,
  };
}

function BrokerPriceBox({ a, broker }: { a: AnalysisResponse; broker: ReturnType<typeof useBrokerOffset> }) {
  const ref = a.livePriceAt ?? a.generatedAt;
  const late = broker.enteredAt !== null && broker.enteredAt - ref > 60_000;
  return (
    <div className="rounded-lg bg-card2 px-3 py-2">
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-mute">Prix « Sell » affiché chez ton broker maintenant</span>
        <input
          inputMode="decimal"
          value={broker.text}
          onChange={ev => broker.setText(ev.target.value)}
          placeholder={fmt(a.engine.price, a.decimals)}
          className="num w-28 rounded border border-line bg-bg px-2 py-1 text-right text-sm"
        />
      </label>
      <p className="mt-1 text-xs leading-snug text-mute">
        Optionnel. Les niveaux du plan sont alors recalés sur le prix de ton broker (mêmes distances, même R:R). Saisis-le juste après l’analyse.
      </p>
      {broker.offset !== 0 && (
        <p className="mt-1 text-xs text-gold">
          Écart broker − app : {broker.offset > 0 ? '+' : ''}{fmt(broker.offset, a.decimals)}{a.pair === 'XAU/USD' ? ' $' : ''}. {a.final.plan ? 'Les niveaux du plan sont recalés.' : 'Pas de plan pour l’instant : rien à recaler.'}
        </p>
      )}
      {broker.text.trim() !== '' && broker.offset === 0 && !broker.error && <p className="mt-1 text-xs text-up">Même prix que l’app : aucun recalage nécessaire.</p>}
      {broker.error && <p className="mt-1 text-xs text-warn">{broker.error}</p>}
      {late && !broker.error && (
        <p className="mt-1 text-xs text-warn">Analyse faite il y a plus d’une minute : relance l’analyse puis saisis le prix tout de suite, sinon le recalage peut être faux.</p>
      )}
    </div>
  );
}

const STEP_LABELS: Record<'htf' | 'declencheur' | 'zone' | 'risque', string> = {
  htf: '1. Contexte HTF',
  declencheur: '2. Sweep → displacement → CHoCH',
  zone: '3. FVG en premium / discount',
  risque: '4. Stop, TP et R:R',
};

/** Résultat du pipeline Gemini, tel que recontrôlé par le serveur. Les niveaux affichés sont ceux du contrôle. */
const STAGE_LABEL: Record<M5Execution['stage'], { label: string; tone: string }> = {
  attente_zone: { label: '1/3 · attente de la zone', tone: 'bg-warn/15 text-warn' },
  attente_choch: { label: '2/3 · attente du CHoCH M5', tone: 'bg-warn/15 text-warn' },
  ordre: { label: '3/3 · ordre à placer', tone: 'bg-up/15 text-up' },
  manqué: { label: 'trade manqué', tone: 'bg-down/15 text-down' },
  annulé: { label: 'annulé', tone: 'bg-down/15 text-down' },
  indisponible: { label: 'M5 indisponible', tone: 'bg-down/15 text-down' },
};

/** Volume profile en ticks FxPro : repères d'information, hors verdict. */
function VolumeProfileCard({ vp, dec, shift }: { vp: NonNullable<AnalysisResponse['volumeProfile']>; dec: number; shift: number }) {
  const s = (v: number) => fmt(v + shift, dec);
  const Row = ({ label, p }: { label: string; p: NonNullable<typeof vp.today> | null }) =>
    p ? (
      <div className="grid grid-cols-4 gap-2 rounded-lg bg-card2 px-3 py-2 text-xs">
        <div className="text-mute">{label}</div>
        <div><span className="text-mute">POC </span><span className="num font-semibold text-gold">{s(p.poc)}</span></div>
        <div><span className="text-mute">VAH </span><span className="num">{s(p.vah)}</span></div>
        <div><span className="text-mute">VAL </span><span className="num">{s(p.val)}</span></div>
      </div>
    ) : null;
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label">Volume profile (ticks FxPro)</div>
        <span className="rounded px-1.5 py-0.5 text-xs font-bold text-mute">information</span>
      </div>
      <div className="space-y-1.5">
        <Row label="Aujourd’hui" p={vp.today} />
        <Row label="Veille" p={vp.yesterday} />
      </div>
      {vp.priceVsYesterday && (
        <p className="mt-2 text-xs text-ink/80">
          Prix {vp.priceVsYesterday === 'dans' ? 'dans la' : `${vp.priceVsYesterday} de la`} zone de valeur de la veille.
        </p>
      )}
      <p className="mt-1 text-xs leading-snug text-mute">
        Volume en ticks du broker (pas de volume centralisé sur le forex et l’or spot). POC = prix le plus échangé, VAH/VAL = zone de 70 % du volume. Repère seulement : il ne compte pas dans le verdict tant qu’il n’a pas été validé au backtest.
      </p>
    </section>
  );
}

/** Mode entraînement (TEST, compte démo) : pourquoi ce n'est pas un signal du protocole, et où en est l'exécution M5. */
function TrainingCard({ a, shift }: { a: AnalysisResponse; shift: number }) {
  const t = a.engine.training!;
  const long = t.setup.direction === 'acheter';
  void shift;
  return (
    <section className="card border border-dashed border-gold/60 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label">Entraînement (TEST) — compte démo uniquement</div>
        <span className={cx('rounded px-2 py-0.5 text-xs font-bold text-white', long ? 'bg-up' : 'bg-down')}>{long ? 'ACHAT TEST' : 'VENTE TEST'}</span>
      </div>
      <p className="text-sm leading-snug text-ink/90">
        Balayage → displacement → CHoCH M15 en kill zone, mais ce n’est pas un signal du protocole. Il manque : {t.missing.join(', ') || '—'}.
      </p>
      {t.ready === false && (
        <p className="mt-2 rounded-lg bg-card2 px-3 py-2 text-sm leading-snug text-ink/80">
          {t.message} <span className="text-mute">Pas d’ordre TEST tant que le CHoCH M5 n’a pas donné l’entrée.</span>
        </p>
      )}
    </section>
  );
}

/** Preuve que l'app surveille, sous « Attendre » : dernier contrôle et prochaines kill zones en heure du Maroc. */
function WatchLine() {
  const { data, failed } = useWatchStatus();
  const last = data?.lastTick?.at ?? null;
  const ago = last ? Math.max(0, Math.round((Date.now() - last) / 60_000)) : null;
  return (
    <div className="card px-4 py-3 text-sm leading-snug">
      {failed && !data ? (
        <span className="text-warn">Surveillance injoignable pour l’instant.</span>
      ) : data?.watchConfigured ? (
        <span>
          <span className="font-semibold text-up">● Surveillance active</span>
          {ago !== null ? ` · dernier contrôle il y a ${ago < 1 ? 'moins d’1' : ago} min` : ' · pas encore de contrôle aujourd’hui'}
          {data.telegram ? ' · alerte Telegram dès qu’un ordre est prêt' : ''}
        </span>
      ) : (
        <span className="text-mute">Surveillance automatique non configurée : relance l’analyse pendant les kill zones.</span>
      )}
      <div className="mt-1 text-xs text-mute">Kill zones : {killzonesMaroc()}</div>
    </div>
  );
}

function CopyValue({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value.replace(/\s/g, ''));
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* presse-papiers indisponible : la valeur reste lisible */
        }
      }}
      className="flex min-h-[52px] items-center justify-between gap-2 rounded-lg bg-card2 px-3 py-2 text-left"
    >
      <span>
        <span className="block text-xs text-mute">{label}</span>
        <span className={cx('num text-lg font-bold', tone)}>{value}</span>
      </span>
      {done ? <Check className="h-4 w-4 text-up" /> : <Copy className="h-4 w-4 text-mute" />}
    </button>
  );
}

/**
 * La carte à suivre sur cTrader : type d'ordre en très gros (LIMIT, pas au marché), UN seul volume, perte si stop,
 * niveaux à copier, expiration. Règle du desk en rouge si le compte ne permet pas ce trade.
 */
function OrderCard(p: {
  pair: string;
  long: boolean;
  limit: boolean;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  lots: number | null;
  riskUsd: number;
  riskPct: number;
  cent: boolean;
  dec: number;
  validUntil: number | null;
  deskMsg: string | null;
  minLotUsd: number | null;
  test?: boolean;
}) {
  const side = p.long ? 'BUY' : 'SELL';
  const type = p.limit ? `${side} LIMIT` : `${side} au marché`;
  const unit = p.cent ? ' lot cent' : ' lot';
  const split = p.lots && p.tp2 !== null ? splitOrders(p.lots) : null;
  const f = (v: number | null) => (v === null ? '—' : fmt(v, p.dec));
  return (
    <section className={cx('card overflow-hidden', p.test && 'border-dashed border-gold/60')}>
      <div className={cx('px-4 py-3 text-white', p.long ? 'bg-up' : 'bg-down')}>
        <div className="text-sm font-semibold opacity-90">{p.test ? 'Ordre TEST à passer sur cTrader (démo)' : 'Ordre à passer sur cTrader'}</div>
        <div className="text-[32px] font-extrabold leading-tight tracking-tight">{type}</div>
        {p.limit && <div className="text-sm font-bold">Ordre en attente — PAS au marché</div>}
      </div>
      <div className="space-y-3 p-4">
        {p.deskMsg && (
          <p className="rounded-lg border border-down/50 bg-down/10 px-3 py-2 text-sm font-semibold leading-snug text-down">
            Ne place pas cet ordre. {p.deskMsg}
          </p>
        )}
        <div className="rounded-lg border-2 border-gold/50 bg-gold/5 px-3 py-2">
          <div className="text-xs text-mute">Volume total</div>
          <div className="num text-[28px] font-extrabold leading-tight">{p.lots === null ? '—' : `${p.lots.toFixed(2)}${unit}`}</div>
          <div className="text-sm">
            Perte si stop : <b className="num">≈ {p.riskUsd < 10 ? p.riskUsd.toFixed(2) : Math.round(p.riskUsd)} $</b> ({p.riskPct} % du compte)
          </div>
          {p.lots === 0 && p.minLotUsd !== null && (
            <p className="mt-1 text-sm text-warn">Stop trop large : même 0,01 lot ferait perdre ≈ {p.minLotUsd.toFixed(2)} $. Ne prends pas ce trade.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <CopyValue label={p.limit ? 'Prix de l’ordre limite' : 'Entrée'} value={f(p.entry)} tone="text-gold" />
          <CopyValue label="Stop loss" value={f(p.sl)} tone="text-down" />
          <CopyValue label={p.tp2 !== null ? 'Take profit (TP2)' : 'Take profit'} value={f(p.tp2 ?? p.tp1)} tone="text-up" />
          {p.tp2 !== null && <CopyValue label="TP1 (niveau de sécurisation)" value={f(p.tp1)} tone="text-up" />}
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-snug">
          <li>
            cTrader : <b>Nouvel ordre → Ordre en attente → {p.limit ? 'Limit' : 'Marché'} → {p.long ? 'Buy' : 'Sell'}</b>
          </li>
          <li>
            Prix {f(p.entry)}, volume <b>{p.lots === null ? '—' : p.lots.toFixed(2)}</b>, stop {f(p.sl)}, take profit {f(p.tp2 ?? p.tp1)} — tous dans le ticket.
          </li>
          {p.limit && p.validUntil && <li>Expiration : {localTime(p.validUntil)} (heure du Maroc), sinon annule-le toi-même à cette heure.</li>}
          {p.tp2 !== null && <li>Gestion : à l’approche de TP2, remonte ton stop sur TP1 ({f(p.tp1)}) pour sécuriser le gain.</li>}
        </ol>
        {split && (
          <p className="text-xs leading-snug text-mute">
            Variante en 2 ordres (50 % encaissés à TP1) : {split.lot1.toFixed(2)} lot avec TP {f(p.tp1)} + {split.lot2.toFixed(2)} lot avec TP {f(p.tp2)}, puis stop de l’ordre 2 au prix d’entrée à TP1.
          </p>
        )}
        <p className="text-xs leading-snug text-mute">Une fois l’ordre placé, le journal FxPro l’enregistre tout seul (lu sur ton compte). Rien n’est passé par l’app.</p>
      </div>
    </section>
  );
}

/** Exécution affinée M5 : le setup M15 est valide, l'entrée attend le CHoCH M5 dans la zone. */
function ExecutionCard({ x, dec, shift }: { x: M5Execution; dec: number; shift: number }) {
  const st = STAGE_LABEL[x.stage];
  const s = (v: number) => fmt(v + shift, dec);
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label">Exécution M5 (entrée affinée)</div>
        <span className={cx('rounded px-1.5 py-0.5 text-xs font-bold', st.tone)}>{st.label}</span>
      </div>
      <p className="text-xs leading-snug text-ink/90">{x.message}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-card2 px-3 py-2 text-xs">
        <div><div className="text-mute">Zone M15</div><div className="num">{s(x.zone.bottom)} – {s(x.zone.top)}</div></div>
        <div><div className="text-mute">Niveau CHoCH M5</div><div className="num">{x.chochLevel !== null ? s(x.chochLevel) : '—'}</div></div>
        <div><div className="text-mute">Surveillance jusqu’à</div><div className="num">{localTime(x.order?.validUntil ?? x.until)}</div></div>
      </div>
      {shift !== 0 && <p className="mt-1 text-xs text-mute">Niveaux recalés sur ton broker ({shift > 0 ? '+' : ''}{fmt(shift, dec)}).</p>}
    </section>
  );
}

function PipelineCard({ p, dec }: { p: PipelineReport; dec: number }) {
  const g = p.gemini;
  const tone = p.status === 'VALIDÉ' ? 'bg-up/15 text-up' : p.status === 'REJETÉ' ? 'bg-down/15 text-down' : 'bg-warn/15 text-warn';
  const disagree = g && g.statut === 'VALIDÉ' && p.status === 'REJETÉ';
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="label flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-gold" /> Pipeline SMC Gemini (double validation)
        </div>
        <span className={cx('rounded px-1.5 py-0.5 text-xs font-bold', tone)}>{p.status}</span>
      </div>
      <p className="text-xs leading-snug text-ink/90">{p.message}</p>
      {disagree && <p className="mt-1 text-xs text-warn">Gemini avait validé, le contrôle serveur sur les vraies bougies a refusé : on ne trade pas.</p>}
      {g && (
        <ul className="mt-3 space-y-1.5 text-xs">
          {(Object.keys(STEP_LABELS) as (keyof typeof STEP_LABELS)[]).map(k => (
            <li key={k} className="flex gap-2">
              <span className={g.etapes[k].ok ? 'text-up' : 'text-down'}>{g.etapes[k].ok ? '✓' : '✗'}</span>
              <span>
                <span className="font-semibold">{STEP_LABELS[k]}</span> — <span className="text-mute">{g.etapes[k].detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {g?.statut === 'VALIDÉ' && g.direction && g.entree !== null && (
        <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg bg-card2 px-3 py-2 text-xs">
          <div><div className="text-mute">Sens</div><div className="num font-semibold">{g.direction === 'BUY' ? 'Achat' : 'Vente'}</div></div>
          <div><div className="text-mute">Entrée</div><div className="num">{fmt(g.entree, dec)}</div></div>
          <div><div className="text-mute">Stop</div><div className="num">{fmt(g.stop_loss, dec)}</div></div>
          <div><div className="text-mute">TP</div><div className="num">{fmt(g.take_profit, dec)}</div></div>
          <div className="col-span-4 text-mute">R:R recalculé par le serveur : 1:{p.guard?.rrServer?.toFixed(2) ?? '—'} (Gemini : 1:{g.rr?.toFixed(2)})</div>
        </div>
      )}
      {p.guard && p.guard.checks.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-mute">Contrôles serveur ({p.guard.checks.filter(c => c.ok).length}/{p.guard.checks.length})</summary>
          <ul className="mt-1 space-y-1">
            {p.guard.checks.map(c => (
              <li key={c.key} className="flex gap-2">
                <span className={c.ok ? 'text-up' : 'text-down'}>{c.ok ? '✓' : '✗'}</span>
                <span>{c.label} — <span className="text-mute">{c.detail}</span></span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-2 text-xs text-mute">
        {p.model ? `${p.model} · ` : ''}{(p.latencyMs / 1000).toFixed(1)} s · ~{p.payloadTokens} tokens envoyés. Un trade n’est proposé que si le moteur ET Gemini sont d’accord.
      </p>
    </section>
  );
}
