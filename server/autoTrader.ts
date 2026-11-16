// Bot de TEST : passe les ordres des alertes « ordre prêt » sur le compte DÉMO cTrader, avec le lot conseillé.
// Éteint par défaut. Il faut les deux : BOT_MODE=demo dans les Secrets, ET un jeton cTrader avec droit de trading sur un
// compte démo. Sur un compte réel (ou sans jeton de trading) il refuse de partir.
//
// Gestion identique à l'app : la moitié du volume vise TP1, l'autre moitié TP2 ; quand TP1 est touché, le stop de la
// 2e moitié passe au prix d'entrée. Les deux moitiés sont deux ordres LIMIT (étiquettes ORA|<id>|A et ORA|<id>|B).
// Un seul trade du bot à la fois ; au plus BOT_MAX_PER_DAY ordres par jour (défaut 3).

export interface BotOrder {
  pair: string;
  kind: 'ordre' | 'test';
  direction: 'acheter' | 'vendre';
  entryType: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  /** fin de validité de l'ordre limite (ms) */
  validUntil: number | null;
  /** lot conseillé par l'app (solde × risque prévu) */
  lots: number | null;
  /** prix du moment : sert à vérifier que l'ordre limite est du bon côté */
  price: number;
}

export interface Spec {
  symbolId: number;
  digits: number;
  lotSize: number;
  minVolume: number;
  stepVolume: number;
  maxVolume: number;
}

/** Ce dont le bot a besoin du client cTrader (remplaçable en test). */
export interface TradingPort {
  tradingGate(): { ok: boolean; reason: string };
  symbolSpec(pair: string): Promise<Spec>;
  reconcile(): Promise<{ positions: any[]; orders: any[] }>;
  placeLimit(o: { pair: string; side: 'BUY' | 'SELL'; volume: number; limit: number; sl: number; tp: number | null; expiresAt: number; label: string; comment: string }): Promise<void>;
  cancelOrder(orderId: number): Promise<void>;
  amendPositionSl(positionId: number, sl: number, tp: number | null): Promise<void>;
}

export interface BotResult {
  placed: boolean;
  /** message prêt à afficher / envoyer sur Telegram */
  message: string;
  /** détail d'un ordre passé (pour l'historique) */
  detail?: { botId: string; lots: number; entry: number; sl: number; tp1: number; tp2: number | null };
}

export const BOT_LABEL = 'ORA';
const FOUR_HOURS = 4 * 3_600_000;

export function botEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BOT_MODE || '').trim().toLowerCase() === 'demo';
}

/** Types d'alertes que le bot prend (défaut : ordre et test). */
export function botKinds(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = (env.BOT_KINDS || 'ordre,test').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return new Set(raw.filter(k => k === 'ordre' || k === 'test'));
}

/** Volume (1/100 d'unité) arrondi au pas du broker ; 0 si sous le minimum. */
export function volumeFor(lots: number, spec: Spec): number {
  const v = Math.floor((lots * spec.lotSize) / spec.stepVolume + 1e-9) * spec.stepVolume;
  return v >= spec.minVolume ? Math.min(v, spec.maxVolume) : 0;
}

export function splitVolume(total: number, spec: Spec): [number, number] | null {
  const half = Math.floor(total / 2 / spec.stepVolume + 1e-9) * spec.stepVolume;
  if (half < spec.minVolume) return null;
  const rest = total - half;
  return rest >= spec.minVolume ? [half, rest] : null;
}

const round = (v: number, d: number) => Number(v.toFixed(d));

function tagOf(x: any): { id: string; part: string } | null {
  const m = /^ORA\|([a-z0-9]+)\|([AB])$/.exec(String(x?.tradeData?.label ?? ''));
  return m ? { id: m[1], part: m[2] } : null;
}

export class AutoTrader {
  private day = '';
  private count = 0;
  constructor(private port: TradingPort, private maxPerDay = Number(process.env.BOT_MAX_PER_DAY) || 3, private now: () => number = Date.now) {}

  private bumpDay() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
    }
  }

  /** Passe l'ordre d'une alerte. Ne lève jamais : renvoie le motif du refus ou de l'erreur. */
  async place(o: BotOrder): Promise<BotResult> {
    const no = (message: string): BotResult => ({ placed: false, message: `🤖 Bot démo : ordre NON passé — ${message}` });
    try {
      if (!botKinds().has(o.kind)) return no(`type « ${o.kind} » non pris par le bot (BOT_KINDS).`);
      const gate = this.port.tradingGate();
      if (!gate.ok) return no(gate.reason);
      if (o.entryType !== 'limite') return no('seuls les ordres limite sont gérés.');
      if (!o.lots || o.lots <= 0) return no('pas de lot conseillé (solde ou stop illisible).');
      const sell = o.direction === 'vendre';
      if (sell ? o.entry <= o.price : o.entry >= o.price) return no(`le prix (${o.price}) a déjà dépassé l’entrée limite (${o.entry}).`);
      if (sell ? !(o.sl > o.entry && o.tp1 < o.entry) : !(o.sl < o.entry && o.tp1 > o.entry)) return no('niveaux incohérents (stop / objectif du mauvais côté).');
      this.bumpDay();
      if (this.count >= this.maxPerDay) return no(`limite de ${this.maxPerDay} ordres par jour atteinte.`);
      const { positions, orders } = await this.port.reconcile();
      if ([...positions, ...orders].some(x => tagOf(x))) return no('un trade du bot est déjà ouvert ou en attente (un seul à la fois).');
      const spec = await this.port.symbolSpec(o.pair);
      const total = volumeFor(o.lots, spec);
      if (!total) return no(`lot conseillé ${o.lots} sous le minimum du broker.`);
      const d = spec.digits;
      const id = this.now().toString(36).slice(-6);
      const expiresAt = o.validUntil && o.validUntil > this.now() + 60_000 ? o.validUntil : this.now() + FOUR_HOURS;
      const side = sell ? 'SELL' : 'BUY';
      const common = { pair: o.pair, side: side as 'BUY' | 'SELL', limit: round(o.entry, d), sl: round(o.sl, d), expiresAt, comment: `ORA ${o.kind} ${o.pair}` };
      const parts = o.tp2 !== null ? splitVolume(total, spec) : null;
      if (parts) {
        await this.port.placeLimit({ ...common, volume: parts[0], tp: round(o.tp1, d), label: `${BOT_LABEL}|${id}|A` });
        try {
          await this.port.placeLimit({ ...common, volume: parts[1], tp: round(o.tp2!, d), label: `${BOT_LABEL}|${id}|B` });
        } catch (e: any) {
          // la 2e moitié a échoué : on retire la 1re pour ne pas rester avec une demi-position sans gestion
          await this.cancelByTag(id).catch(() => undefined);
          throw e;
        }
      } else {
        // pas de TP2 (ou volume trop petit pour couper en deux) : tout vise TP1
        await this.port.placeLimit({ ...common, volume: total, tp: round(o.tp1, d), label: `${BOT_LABEL}|${id}|A` });
      }
      this.count++;
      const lots = total / spec.lotSize;
      return {
        placed: true,
        detail: { botId: id, lots: Number(lots.toFixed(2)), entry: common.limit, sl: common.sl, tp1: round(o.tp1, d), tp2: parts ? round(o.tp2!, d) : null },
        message: `🤖 Bot démo : ordre ${side} LIMIT ${o.pair} passé — ${lots.toFixed(2)} lot @ ${common.limit}, stop ${common.sl}, TP1 ${round(o.tp1, d)}${parts ? `, TP2 ${round(o.tp2!, d)} (moitié / moitié)` : ' (tout à TP1)'}. Valable jusqu'à ${new Date(expiresAt).toISOString().slice(11, 16)} UTC.`,
      };
    } catch (e: any) {
      return no(`erreur cTrader : ${String(e?.message || e).slice(0, 220)}`);
    }
  }

  private async cancelByTag(id: string) {
    const { orders } = await this.port.reconcile();
    for (const od of orders) if (tagOf(od)?.id === id) await this.port.cancelOrder(Number(od.orderId));
  }

  /**
   * À chaque passage de la surveillance : quand la moitié TP1 (A) est fermée et que la moitié TP2 (B) est ouverte,
   * remonte le stop de B au prix d'entrée. Renvoie les messages à envoyer (vide si rien).
   */
  async manage(): Promise<string[]> {
    const out: string[] = [];
    try {
      if (!this.port.tradingGate().ok) return out;
      const { positions, orders } = await this.port.reconcile();
      for (const pos of positions) {
        const t = tagOf(pos);
        if (!t || t.part !== 'B') continue;
        const aStillThere = [...positions, ...orders].some(x => {
          const tx = tagOf(x);
          return tx && tx.id === t.id && tx.part === 'A';
        });
        if (aStillThere) continue;
        const entry = Number(pos.price);
        const sl = Number(pos.stopLoss);
        const sell = Number(pos.tradeData?.tradeSide) === 2 || pos.tradeData?.tradeSide === 'SELL';
        if (!Number.isFinite(entry) || !Number.isFinite(sl)) continue;
        // déjà au point d'entrée (ou mieux) : rien à faire
        if (sell ? sl <= entry + 1e-9 : sl >= entry - 1e-9) continue;
        const tp = Number.isFinite(Number(pos.takeProfit)) && Number(pos.takeProfit) > 0 ? Number(pos.takeProfit) : null;
        await this.port.amendPositionSl(Number(pos.positionId), entry, tp);
        out.push(`🤖 Bot démo : TP1 touché sur ${t.id}, stop de la 2e moitié remonté au point d’entrée (${entry}).`);
      }
    } catch (e: any) {
      out.push(`🤖 Bot démo : gestion du stop en erreur — ${String(e?.message || e).slice(0, 200)}. Vérifie ta position dans cTrader.`);
    }
    return out;
  }
}
