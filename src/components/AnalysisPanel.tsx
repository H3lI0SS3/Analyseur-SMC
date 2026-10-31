import { useRef, useState } from 'react';
import {
  AlertTriangle,
  BookPlus,
  Check,
  ChevronDown,
  ImagePlus,
  Loader2,
  ScanSearch,
  Sparkles,
  X,
} from 'lucide-react';
import type { AnalysisResponse, RiskSettings, Status, Timeframe } from '../types';
import { api, costsFor, cx, distanceLabel, fmt, localDateTime, localTime, lotSize, realRiskUsd } from '../lib/utils';

interface Props {
  pair: string;
  status: Status | null;
  settings: RiskSettings;
  analysis: AnalysisResponse | null;
  setAnalysis: (a: AnalysisResponse | null) => void;
  onAddJournal: (a: AnalysisResponse) => void;
  dailyBlocked: boolean;
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

export function AnalysisPanel({ pair, status, settings, analysis, setAnalysis, onAddJournal, dailyBlocked }: Props) {
  const [note, setNote] = useState('');
  const [image, setImage] = useState<{ base64: string; mediaType: string; preview: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setAdded(false);
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
      const j = await r.json();
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

  return (
    <div className="space-y-3">
      {/* Lancer l'analyse */}
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
            {loading ? 'Analyse en cours…' : `Analyser ${pair}`}
          </button>
        </div>
        {aiOff && (
          <p className="text-[11px] text-mute">
            {status?.providers.length ? 'IA désactivée dans les réglages' : 'Aucune clé IA configurée'} : analyse calculée par le moteur uniquement.
          </p>
        )}
        {error && <p className="rounded-lg bg-down/10 px-3 py-2 text-xs text-down">{error}</p>}
      </section>

      {a && <Result a={a} settings={settings} added={added} dailyBlocked={dailyBlocked} onAdd={() => { onAddJournal(a); setAdded(true); }} />}
    </div>
  );
}

function Result({ a, settings, added, onAdd, dailyBlocked }: { a: AnalysisResponse; settings: RiskSettings; added: boolean; onAdd: () => void; dailyBlocked: boolean }) {
  const { engine: e, final, ai } = a;
  const dec = a.decimals;
  const plan = final.plan;
  const go = final.signal !== 'attendre';
  const okCount = e.checklist.filter(c => c.ok).length;
  const comm = a.costs?.commissionPerLot ?? 0;
  const lots = plan ? lotSize(a.pair, settings.capital, settings.riskPct, plan.entry, plan.sl, comm) : null;
  const riskUsd = plan && lots ? realRiskUsd(a.pair, lots, plan.entry, plan.sl, comm) : (settings.capital * settings.riskPct) / 100;
  const tfs: Timeframe[] = ['D1', 'H4', 'H1', 'M15'];

  return (
    <div className="space-y-3">
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
            <div className="label">Décision</div>
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
                  'rounded px-1.5 py-0.5 text-[10px] font-bold',
                  e.amd.phase === 'Distribution' ? 'bg-gold/20 text-gold' : e.amd.phase === 'Manipulation' ? 'bg-warn/15 text-warn' : 'bg-white/5 text-mute'
                )}
              >
                {e.amd.phase}
                {e.amd.direction ? ` · ${e.amd.direction}` : ''}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-mute">{e.amd.detail}</p>
          </div>
        )}
        {ai?.resume && <p className="mt-3 border-t border-line pt-3 text-sm leading-snug text-ink/90">{ai.resume}</p>}
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-mute">
          <span>
            Prix <span className="num text-ink">{fmt(e.price, dec)}</span> à {localTime(e.priceTime)}
          </span>
          <span>{e.session.name}</span>
          <span>Source : {a.source}</span>
        </div>
        {e.nextNews && (
          <p className="mt-2 text-[11px] text-mute">
            Prochaine annonce forte : <span className="text-ink">{e.nextNews.title}</span> ({e.nextNews.currency}), {localDateTime(e.nextNews.t)}
          </p>
        )}
        {a.warnings.map(w => (
          <p key={w} className="mt-2 flex gap-1.5 text-[11px] leading-snug text-warn">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {w}
          </p>
        ))}
      </section>

      {/* Plan */}
      {plan && (
        <section className={cx('card p-4', !go && 'opacity-80')}>
          <div className="mb-3 flex items-center justify-between">
            <div className="label">{go ? 'Plan de trade' : 'Plan en préparation (pas d’entrée pour l’instant)'}</div>
            <span className="text-[10px] text-mute">{plan.origin}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Level label="Entrée" value={fmt(plan.entry, dec)} cls="text-gold" />
            <Level label="Stop loss" value={fmt(plan.sl, dec)} sub={distanceLabel(a.pair, plan.entry, plan.sl)} cls="text-down" />
            <Level label="TP1" value={fmt(plan.tp1, dec)} sub={`R:R 1:${plan.rr1.toFixed(1)}`} cls="text-up" />
            <Level label="TP2" value={fmt(plan.tp2, dec)} sub={plan.rr2 ? `R:R 1:${plan.rr2.toFixed(1)}` : 'pas de 2e cible'} cls="text-up" />
          </div>
          <div className="mt-3 rounded-lg bg-card2 px-3 py-2 text-xs">
            <div className="flex justify-between">
              <span className="text-mute">Taille pour {settings.riskPct} % de risque</span>
              <span className="num font-semibold">{lots === null ? '—' : `${lots.toFixed(2)} lot`}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-mute">Perte réelle si SL touché</span>
              <span className="num">≈ {riskUsd.toFixed(0)} $</span>
            </div>
            <div className="mt-1 text-[10px] text-mute">
              R:R nets : spread {a.pair === 'XAU/USD' ? `${a.costs.spread.toFixed(2)} $` : `${(a.costs.spread / 0.0001).toFixed(1)} pip`} et commission {comm} $/lot inclus.
            </div>
            {lots === 0 && <p className="mt-1 text-warn">Stop trop large pour ton capital : taille inférieure à 0,01 lot.</p>}
          </div>
          {e.setup && <p className="mt-2 text-[11px] text-mute">Zone : {e.setup.zoneLabel}</p>}
          {e.setup?.validUntil && plan.entryType === 'limite' && (
            <p className="mt-1 text-[11px] text-mute">Ordre limite à annuler s’il n’est pas exécuté avant {localTime(e.setup.validUntil)}.</p>
          )}
          {final.notes.map(n => (
            <p key={n} className="mt-1 text-[11px] text-mute">• {n}</p>
          ))}
          {go && (
            <button
              onClick={onAdd}
              disabled={added || dailyBlocked}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-gold py-2.5 text-sm font-semibold text-gold disabled:opacity-50"
            >
              {added ? <Check className="h-4 w-4" /> : <BookPlus className="h-4 w-4" />}
              {added ? 'Ajouté au journal' : dailyBlocked ? 'Limite de perte du jour atteinte' : 'Je prends ce trade → journal'}
            </button>
          )}
        </section>
      )}

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
                  {c.core && <span className="ml-1.5 text-[10px] text-gold">obligatoire</span>}
                </div>
                <div className="text-[11px] leading-snug text-mute">{c.detail}</div>
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
            <div className="mb-1 flex justify-between text-[11px] text-mute">
              <span className="num">{fmt(e.dealingRange.low, dec)}</span>
              <span>Range H1 : {e.dealingRange.label}</span>
              <span className="num">{fmt(e.dealingRange.high, dec)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-gradient-to-r from-up/40 via-card2 to-down/40">
              <div className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded bg-ink" style={{ left: `calc(${Math.min(100, Math.max(0, e.dealingRange.position * 100))}% - 2px)` }} />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-mute">
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
                {l.swept && <span className="ml-1 text-[10px]">(déjà pris)</span>}
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
                {z.touched && <span className="ml-1 text-[10px] text-mute">(déjà testé)</span>}
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
              <span className={cx('rounded px-1.5 py-0.5 text-[10px] font-bold', ai.verdict === 'VALIDÉ' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
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
              <p className="pt-2 text-[10px] text-mute">{ai.engine} · {localDateTime(a.generatedAt)}</p>
            </div>
          )}
        </section>
      )}

      <p className="px-2 text-center text-[10px] leading-snug text-mute">
        Outil d’aide à la décision, pas un conseil en investissement. Le trading avec effet de levier peut faire perdre plus que la mise : teste d’abord en démo.
      </p>
    </div>
  );
}

function Level({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls: string }) {
  return (
    <div className="rounded-lg bg-card2 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-mute">{label}</div>
      <div className={cx('num text-base font-semibold', cls)}>{value}</div>
      {sub && <div className="text-[10px] text-mute">{sub}</div>}
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
