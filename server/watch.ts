// Surveillance automatique : appelée toutes les 5 minutes par une tâche programmée externe (cron-job.org),
// car l'hébergement AI Studio (Cloud Run) se met en veille sans visiteur.
// Moteur principal + exécution M5 (règles en direct). Aucun ordre n'est passé : on prévient, le trader décide.
import { PAIRS } from './marketData';
import { PAUSED_PAIRS, killzoneStart } from './execution';
import { getCTrader } from './ctrader';
import { marketClosed, maTime } from './time';
import { esc, sendTelegram } from './telegram';

export type AnalyzeFn = (opts: { pair: string; provider?: any }) => Promise<any>;
export type NotifyFn = (html: string) => Promise<{ ok: boolean; error?: string }>;

export interface WatchAlert {
  id: string;
  kind: 'ordre' | 'setup' | 'test';
  pair: string;
  at: number;
  title: string;
  /** texte de l'alerte (identique au message Telegram, sans HTML) */
  text: string;
  telegram: { ok: boolean; error?: string };
  /** analyse complète : permet « Ajouter au journal » dans l'app tant qu'elle a moins de 10 minutes */
  analysis: any;
}

export interface TickResult {
  at: number;
  skipped: string | null;
  checked: { pair: string; verdict: string; stage: string | null; alert: WatchAlert['kind'] | null; error?: string }[];
}

const MAX_ALERTS = 30;
/** Une même alerte n'est pas renvoyée avant 8 h (déduplication). */
const DEDUP_MS = 8 * 3_600_000;

export class Watcher {
  alerts: WatchAlert[] = [];
  lastTick: TickResult | null = null;
  private sent = new Map<string, number>();

  constructor(
    private analyze: AnalyzeFn,
    private notify: NotifyFn = sendTelegram,
    /** hors kill zone, on cherche quand même les signaux d'entraînement si la source est gratuite (cTrader) */
    private offKillzone: () => boolean = () => !!getCTrader(),
    private onlyPairs?: string[]
  ) {}

  /** Paires surveillées : toutes celles qui ne sont pas en pause. */
  get pairs() {
    return (this.onlyPairs ?? Object.keys(PAIRS)).filter(p => !PAUSED_PAIRS[p]);
  }

  async tick(now = Date.now()): Promise<TickResult> {
    const result: TickResult = { at: now, skipped: null, checked: [] };
    if (marketClosed(now)) result.skipped = 'Marché fermé.';
    else if (killzoneStart(now) === null && !this.offKillzone())
      result.skipped = 'Hors kill zone (Londres 02–05 h, New York 07–10 h, heure de New York) : aucune entrée possible.';
    if (result.skipped) {
      this.lastTick = result;
      return result;
    }
    for (const pair of this.pairs) {
      try {
        // 1er passage rapide sans IA ; si un setup apparaît, analyse complète comme dans l'app (avec Gemini)
        let a = await this.analyze({ pair, provider: 'none' });
        if (a?.final?.signal !== 'attendre' || a?.execution) a = await this.analyze({ pair, provider: 'auto' });
        const alert = this.alertFor(a, now);
        if (alert) {
          alert.telegram = await this.notify(toHtml(alert));
          this.alerts = [alert, ...this.alerts].slice(0, MAX_ALERTS);
        }
        result.checked.push({ pair, verdict: a?.final?.signal ?? '?', stage: a?.execution?.stage ?? null, alert: alert?.kind ?? null });
      } catch (e: any) {
        result.checked.push({ pair, verdict: 'erreur', stage: null, alert: null, error: String(e?.message || e).slice(0, 200) });
      }
    }
    this.lastTick = result;
    return result;
  }

  /** Alerte à envoyer pour cette analyse (null si rien de nouveau). */
  private alertFor(a: any, now: number): WatchAlert | null {
    const plan = a?.final?.plan;
    const x = a?.execution;
    for (const [k, t] of this.sent) if (now - t > DEDUP_MS) this.sent.delete(k);
    let kind: WatchAlert['kind'] | null = null;
    let key = '';
    if (a?.final?.signal !== 'attendre' && plan && (!x || x.stage === 'ordre')) {
      kind = 'ordre';
      key = `ordre|${a.pair}|${plan.direction}|${plan.entry}|${plan.sl}`;
    } else if (x && (x.stage === 'attente_zone' || x.stage === 'attente_choch') && plan) {
      kind = 'setup';
      key = `setup|${a.pair}|${plan.direction}|${x.zone.bottom}|${x.zone.top}`;
    } else if (a?.final?.signal === 'attendre' && a?.engine?.training?.setup && a.engine.training.ready !== false) {
      kind = 'test';
      key = `test|${a.pair}|${a.engine.training.setup.direction}|${a.engine.training.setup.zoneId}`;
    }
    if (!kind || this.sent.has(key)) return null;
    this.sent.set(key, now);
    const dec = PAIRS[a.pair]?.decimals ?? 2;
    const f = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toFixed(dec));
    const dir = (plan ?? a.engine?.training?.setup)?.direction === 'acheter' ? 'ACHAT' : 'VENTE';
    let title: string;
    let lines: string[];
    if (kind === 'ordre') {
      const until = a.engine?.setup?.validUntil;
      title = `${plan.direction === 'acheter' ? '🟢' : '🔴'} ORA Trader — ${dir} ${a.pair} : ordre prêt`;
      lines = [
        `Ordre ${plan.direction === 'acheter' ? 'Buy' : 'Sell'} ${plan.entryType === 'limite' ? 'Limit' : 'au marché'} : ${f(plan.entry)}`,
        `Stop : ${f(plan.sl)}`,
        `TP1 : ${f(plan.tp1)} (1:${plan.rr1 ?? '—'})${plan.tp2 !== null && plan.tp2 !== undefined ? `  ·  TP2 : ${f(plan.tp2)} (1:${plan.rr2 ?? '—'})` : ''}`,
        until ? `Valable jusqu'à ${maTime(until)} (heure du Maroc)` : '',
        x?.message ? `\n${x.message}` : '',
        `\nOuvre l'app pour la taille de lot et le ticket, vérifie le prix sur FxPro, puis décide. Rien n'est passé automatiquement.`,
      ];
    } else if (kind === 'test') {
      const t = a.engine.training;
      const p = t.setup;
      const tdir = p.direction === 'acheter' ? 'ACHAT' : 'VENTE';
      title = `🧪 TEST entraînement — ${tdir} ${a.pair} (démo uniquement)`;
      lines = [
        `Ordre ${p.direction === 'acheter' ? 'Buy' : 'Sell'} ${p.entryType === 'limite' ? 'Limit' : 'au marché'} : ${f(p.entry)}`,
        `Stop : ${f(p.sl)}`,
        `TP1 : ${f(p.tp1)} (1:${p.rr1 ?? '—'})${p.tp2 !== null && p.tp2 !== undefined ? `  ·  TP2 : ${f(p.tp2)} (1:${p.rr2 ?? '—'})` : ''}`,
        p.validUntil ? `Valable jusqu'à ${maTime(p.validUntil)} (heure du Maroc)` : '',
        `\nPas un signal du protocole. Il manque : ${t.missing.join(', ') || '—'}.`,
        `Risque conseillé : 0,25 %. Rien n'est passé automatiquement.`,
      ];
    } else {
      title = `🟡 ORA Trader — setup ${dir.toLowerCase()} ${a.pair} en préparation`;
      lines = [x.message, `Je t'envoie l'ordre dès que le CHoCH M5 est confirmé.`];
    }
    const text = [title, ...lines.filter(Boolean)].join('\n');
    return { id: `${kind}_${now}_${Math.random().toString(36).slice(2, 7)}`, kind, pair: a.pair, at: now, title, text, telegram: { ok: false }, analysis: a };
  }
}

export function toHtml(al: WatchAlert): string {
  const [first, ...rest] = al.text.split('\n');
  return `<b>${esc(first)}</b>\n${esc(rest.join('\n'))}`;
}

// ---------- Instance partagée ----------
let shared: Watcher | null = null;
export function getWatcher(analyze: AnalyzeFn): Watcher {
  if (!shared) shared = new Watcher(analyze);
  return shared;
}
