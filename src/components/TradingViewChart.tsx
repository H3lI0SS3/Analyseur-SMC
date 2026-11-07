// Graphique TradingView en direct (widget officiel « Advanced Real-Time Chart »), M5 / M15 / D1.
// Pour regarder le marché ; les niveaux du plan restent dessinés sur le graphique de l'app.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
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
  const [interval, setIv] = useState<Interval>(() => load<{ iv?: Interval }>('sa_tv', {}).iv ?? '15');
  const [open, setOpen] = useState<boolean>(() => load<{ open?: boolean }>('sa_tv', {}).open ?? true);
  useEffect(() => save('sa_tv', { iv: interval, open }), [interval, open]);

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
      timezone: 'Africa/Casablanca',
      theme: 'dark',
      style: '1',
      locale: 'fr',
      allow_symbol_change: false,
      hide_side_toolbar: true,
      hide_volume: true,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    el.appendChild(script);
    return () => {
      el.innerHTML = '';
    };
  }, [pair, interval, open]);

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left">
          <span className="label">TradingView en direct</span>
          <span className="text-[10px] text-mute">{TV_SYMBOLS[pair]}</span>
          {open ? <ChevronUp className="h-3.5 w-3.5 text-mute" /> : <ChevronDown className="h-3.5 w-3.5 text-mute" />}
        </button>
        {open && (
          <div className="flex gap-1">
            {INTERVALS.map(iv => (
              <button
                key={iv.id}
                onClick={() => setIv(iv.id)}
                className={cx('rounded-md px-2 py-0.5 text-[11px] font-semibold', interval === iv.id ? 'bg-gold text-bg' : 'bg-card2 text-mute hover:text-ink')}
              >
                {iv.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <div ref={box} className="tradingview-widget-container h-[380px] w-full" />}
    </section>
  );
}
