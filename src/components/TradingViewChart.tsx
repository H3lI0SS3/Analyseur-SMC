// Graphique TradingView en direct (widget officiel « Advanced Real-Time Chart »), M5 / M15 / D1.
// Grand format, thème clair assorti à l'app, et mode plein écran. Les niveaux du plan restent sur le graphique de l'app.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { cx, load, save } from '../lib/utils';

/** Flux OANDA (spot) : très proche de FxPro ; le graphique de l'app (cTrader) montre le prix exact du broker. */
export const TV_SYMBOLS: Record<string, string> = { 'XAU/USD': 'OANDA:XAUUSD', 'EUR/USD': 'OANDA:EURUSD' };
const INTERVALS = [
  { id: '5', label: 'M5' },
  { id: '15', label: 'M15' },
  { id: 'D', label: 'D1' },
] as const;
type Interval = (typeof INTERVALS)[number]['id'];

export function TradingViewChart({ pair }: { pair: string }) {
  const box = useRef<HTMLDivElement>(null);
  // replié par défaut : le verdict et l'ordre passent avant le graphique (clé v2 = nouveau défaut pour tout le monde)
  const [interval, setIv] = useState<Interval>(() => load<{ iv?: Interval }>('sa_tv2', {}).iv ?? '15');
  const [open, setOpen] = useState<boolean>(() => load<{ open?: boolean }>('sa_tv2', {}).open ?? false);
  const [full, setFull] = useState(false);
  useEffect(() => save('sa_tv2', { iv: interval, open }), [interval, open]);

  // Échap ferme le plein écran ; le défilement de la page est bloqué pendant ce temps
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [full]);

  useEffect(() => {
    const el = box.current;
    if (!el || !open) return;
    el.innerHTML = '';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = '100%';
    widget.style.width = '100%';
    el.appendChild(widget);
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: TV_SYMBOLS[pair] ?? 'OANDA:XAUUSD',
      interval,
      timezone: 'Etc/UTC', // heure du Maroc (GMT depuis le 20/09/2026)
      theme: 'light',
      style: '1',
      locale: 'fr',
      backgroundColor: '#ffffff',
      gridColor: 'rgba(221, 225, 242, 0.6)',
      allow_symbol_change: false,
      hide_side_toolbar: !full,
      hide_volume: true,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    el.appendChild(script);
    return () => {
      el.innerHTML = '';
    };
  }, [pair, interval, open, full]);

  return (
    <section className={cx('card overflow-hidden', full && 'fixed inset-0 z-50 flex flex-col rounded-none border-0')}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button onClick={() => !full && setOpen(o => !o)} className="flex items-center gap-1.5 text-left" aria-expanded={open}>
          <span className="label">TradingView</span>
          <span className="hidden text-xs text-mute sm:inline">{TV_SYMBOLS[pair]}</span>
          {!full && (open ? <ChevronUp className="h-3.5 w-3.5 text-mute" /> : <ChevronDown className="h-3.5 w-3.5 text-mute" />)}
        </button>
        {open && (
          <div className="flex items-center gap-1">
            {INTERVALS.map(iv => (
              <button
                key={iv.id}
                onClick={() => setIv(iv.id)}
                aria-pressed={interval === iv.id}
                className={cx('rounded-md px-2.5 py-1 text-[12px] font-semibold', interval === iv.id ? 'bg-gold text-white' : 'bg-card2 text-mute hover:text-ink')}
              >
                {iv.label}
              </button>
            ))}
            <button
              onClick={() => setFull(f => !f)}
              className="ml-1 rounded-md bg-card2 p-1.5 text-mute hover:text-ink"
              aria-label={full ? 'Quitter le plein écran' : 'Plein écran'}
              title={full ? 'Quitter le plein écran (Échap)' : 'Plein écran'}
            >
              {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>
      {open && <div ref={box} className={cx('tradingview-widget-container w-full', full ? 'flex-1' : 'h-[clamp(420px,62vh,720px)]')} />}
    </section>
  );
}
